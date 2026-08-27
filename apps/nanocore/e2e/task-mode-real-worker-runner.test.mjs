import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  assertTaskModeAgentEnvironment,
  createRealClients,
  evaluateTaskModeRealWorkerPrerequisites,
  fetchTaskModeRealWorker,
  runTaskModeRealWorkerTest,
} from './task-mode-real-worker-runner.mjs';

/** Exact 40-lowercase-hex product commit required by every enabled Task Mode fixture. */
const TASK_MODE_PRODUCT_COMMIT = '0123456789abcdef0123456789abcdef01234567';
/** Exact 64-lowercase-hex host-manifest digest required by every enabled Task Mode fixture. */
const TASK_MODE_HOST_MANIFEST_DIGEST =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
/** Credential-free network source required by every enabled Task Mode fixture. */
const TASK_MODE_GIT_URL = 'https://git.example.test/openkit/repository.git';
/** Exact accepted remote Git commit required by every enabled Task Mode fixture. */
const TASK_MODE_GIT_COMMIT = '89abcdef0123456789abcdef0123456789abcdef';
/** Fixed catalog source referenced by the preprovisioned Task Mode Agent. */
const TASK_MODE_GIT_SOURCE_ID = 'task-mode-repository';

/**
 * Builds one complete opt-in Task Mode env with the required evidence identities.
 *
 * @param {Record<string, string | undefined>} [overrides] Env overrides for one test.
 * @returns {Record<string, string | undefined>} Complete enabled runner env.
 */
function enabledTaskModeEnv(overrides = {}) {
  return {
    OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
    OPENKIT_L6_EVIDENCE_DIR: '/tmp/openkit-task-evidence',
    OPENKIT_L6_TASK_HOST_MANIFEST_DIGEST: TASK_MODE_HOST_MANIFEST_DIGEST,
    OPENKIT_L6_TASK_GIT_COMMIT: TASK_MODE_GIT_COMMIT,
    OPENKIT_L6_TASK_GIT_URL: TASK_MODE_GIT_URL,
    OPENKIT_L6_TASK_NANOCORE_URL: 'http://127.0.0.1:3000',
    OPENKIT_L6_TASK_PRODUCT_COMMIT: TASK_MODE_PRODUCT_COMMIT,
    OPENKIT_L6_TASK_REAL_WORKER: '1',
    OPENKIT_L6_TASK_WORKER_IMAGE_REF: 'example.invalid/openkit-worker:test',
    ...overrides,
  };
}

/**
 * Builds one fully passing fake Task Mode client surface.
 *
 * @param {{ onReviewDecision?: (workspaceId: string, reviewId: string, input: Record<string, unknown>) => void, reviewIds?: string[], workerImageRef: string }} options Fixture options.
 * @returns {{ clients: { admin: Record<string, any>, core: Record<string, any> }, ids: { workspaceId: string } }} Fake clients and stable ids.
 */
function createPassingTaskModeFixture(options) {
  const workspaceId = 'workspace_acceptance';
  const threadId = 'thread_acceptance';
  const turnId = 'turn_acceptance';
  const agentSessionId = 'agent_session_acceptance';
  const packageSnapshotId = 'snapshot_acceptance';
  const origins = [
    'rto_000000000000000000000001',
    'rto_000000000000000000000002',
    'rto_000000000000000000000003',
  ];
  const capabilityCalls = origins.map((runtimeOriginRef, index) => ({
    agentSessionId,
    family: 'llm',
    id: `call_${index + 1}`,
    packageSnapshotId,
    requestId: `request_${index + 1}`,
    runtimeCacheLineageRef: `rcl_00000000000000000000000${(index % 2) + 1}`,
    runtimeOriginRef,
    serviceRef: 'worker-inference-gateway',
    status: 'succeeded',
    threadId,
    turnId,
  }));

  return {
    clients: {
      admin: {
        app: {
          getDiagnostics: async () => ({ boot: { acceptingProductWork: true } }),
        },
        runtimeConfig: {
          createFile: async () => ({ diagnostics: [], file: { exists: true } }),
          reload: async () => ({
            plan: {
              applied: [],
              deferred: [{ path: 'workspaceDataSources' }],
              rejected: [],
              requiresRestart: [],
              warnings: [],
            },
            runtimeConfig: { pendingRestart: [] },
            status: 'applied',
          }),
        },
      },
      core: {
        app: {
          getCapabilityUsage: async () => ({
            capabilityCalls,
            usageRecords: capabilityCalls.map((call) => ({
              capabilityCallId: call.id,
              quantity: 1,
              source: 'llm-gateway-adapter-reported:cache_read',
            })),
          }),
          listAgentEnvironmentPackageSnapshots: async () => ({
            items: [
              {
                agentSessionId,
                backendKind: 'openshell',
                runtimeKind: 'codex',
                snapshot: {
                  backend: {
                    requiredCapabilities: [
                      'trusted-worker-inference-relay',
                      'worker.runtime-provenance.v1',
                    ],
                  },
                  control: { mode: 'direct-nanocore' },
                  credentials: { declarations: [] },
                  llm: {
                    mode: 'gateway',
                    routes: [
                      {
                        credentialVisibility: 'placeholder',
                        endpoint: { upstream: { kind: 'nanocore-gateway' } },
                        model: 'openai-codex/gpt-5.6-sol',
                        providerInstanceId: 'openai_codex',
                      },
                    ],
                  },
                  policy: { secrets: { visibility: 'none' } },
                  providers: { attachments: [] },
                  runtime: { image: { ref: options.workerImageRef } },
                  vault: { grants: [], references: [] },
                  workspace: {
                    inputs: [
                      {
                        access: 'read-write',
                        id: 'repo_remote',
                        kind: 'directory',
                        materialization: {
                          changeSetManifestPath: '/openkit/session/workspace-changes.json',
                          strategy: 'git',
                        },
                        source: {
                          catalogEntryDigest: `sha256:${'1'.repeat(64)}`,
                          commit: TASK_MODE_GIT_COMMIT,
                          kind: 'git',
                          sensitivity: 'internal',
                          sourceId: TASK_MODE_GIT_SOURCE_ID,
                          sourceRef: TASK_MODE_GIT_SOURCE_ID,
                          url: TASK_MODE_GIT_URL,
                        },
                        target: '/workspace/openkit/worktrees/main',
                      },
                    ],
                    root: '/workspace/openkit',
                  },
                },
                snapshotId: packageSnapshotId,
                turnId,
              },
            ],
          }),
          listWorkspaceRuntimeEvidence: async () => ({
            runtimeEvidence: [
              {
                agentSessionId,
                backendType: 'openshell',
                backendVersion: '0.0.99',
                outcome: 'succeeded',
                phase: 'transcript-collection',
                requiredFeatures: ['worker.runtime-provenance.v1'],
                summary:
                  'Worker runtime provenance complete: 4 streams, 6 frames, 6 attributed, 0 unattributed, 1 root, 2 children, 3/3 gateway calls reconciled, gateway complete, bundles root and children.',
                threadId,
                turnId,
              },
            ],
          }),
          startTaskMode: async () => ({
            evidence: { reviewIds: options.reviewIds ?? [] },
            state: 'completed',
            turn: { id: turnId },
          }),
          submitWorkspaceSyncReviewDecision: async (receivedWorkspaceId, reviewId, input) => {
            options.onReviewDecision?.(receivedWorkspaceId, reviewId, input);
            return { review: { id: reviewId, status: 'rejected' } };
          },
        },
        core: {
          createThread: async () => ({ id: threadId }),
          createWorkspace: async () => ({ id: workspaceId }),
          listThreadItems: async () => ({
            items: [
              {
                id: 'assistant_item',
                status: 'completed',
                turnId,
                type: 'assistant-message',
              },
            ],
          }),
        },
        repositories: {
          setDefault: async () => {
            throw new Error('repositories.setDefault must not configure Task Mode acceptance.');
          },
        },
      },
    },
    ids: { workspaceId },
  };
}

/**
 * Builds distinct admin and product clients so a swapped or fallback actor cannot succeed.
 *
 * @param {{ reviewIds?: string[], workerImageRef: string }} options Fixture options.
 * @returns {{ admin: Record<string, any>, adminCalls: string[], core: Record<string, any>, productCalls: string[] }} Split clients.
 */
function createDistinctTaskModeActorClients(options) {
  const fixture = createPassingTaskModeFixture(options);
  const product = fixture.clients.core;
  const adminCalls = [];
  const productCalls = [];
  const track =
    (fn, calls, label) =>
    async (...args) => {
      calls.push(label);
      return fn(...args);
    };
  const refuse = (message) => async () => {
    throw new Error(message);
  };
  const originalGetDiagnostics = fixture.clients.admin.app.getDiagnostics;
  const admin = {
    app: {
      getCapabilityUsage: refuse('admin client must not read product capability usage'),
      getDiagnostics: track(originalGetDiagnostics, adminCalls, 'getDiagnostics'),
      listAgentEnvironmentPackageSnapshots: refuse('admin client must not list AEP snapshots'),
      listWorkspaceRuntimeEvidence: refuse('admin client must not list runtime evidence'),
      startTaskMode: refuse('admin client must not start Task Mode'),
      submitWorkspaceSyncReviewDecision: refuse('admin client must not submit review cleanup'),
    },
    core: {
      createThread: refuse('admin client must not create a Thread'),
      createWorkspace: refuse('admin client must not create a Workspace'),
      listThreadItems: refuse('admin client must not list thread items'),
    },
    repositories: {
      setDefault: refuse('admin client must not set a repository'),
    },
    runtimeConfig: {
      createFile: track(fixture.clients.admin.runtimeConfig.createFile, adminCalls, 'createFile'),
      reload: track(fixture.clients.admin.runtimeConfig.reload, adminCalls, 'reload'),
    },
  };
  product.app.getDiagnostics = refuse('product client must not serve diagnostics');
  product.app.getCapabilityUsage = track(
    product.app.getCapabilityUsage,
    productCalls,
    'getCapabilityUsage'
  );
  product.app.listAgentEnvironmentPackageSnapshots = track(
    product.app.listAgentEnvironmentPackageSnapshots,
    productCalls,
    'listAgentEnvironmentPackageSnapshots'
  );
  product.app.listWorkspaceRuntimeEvidence = track(
    product.app.listWorkspaceRuntimeEvidence,
    productCalls,
    'listWorkspaceRuntimeEvidence'
  );
  product.app.startTaskMode = track(product.app.startTaskMode, productCalls, 'startTaskMode');
  product.app.submitWorkspaceSyncReviewDecision = track(
    product.app.submitWorkspaceSyncReviewDecision,
    productCalls,
    'submitWorkspaceSyncReviewDecision'
  );
  product.core.createThread = track(product.core.createThread, productCalls, 'createThread');
  product.core.createWorkspace = track(
    product.core.createWorkspace,
    productCalls,
    'createWorkspace'
  );
  product.core.listThreadItems = track(
    product.core.listThreadItems,
    productCalls,
    'listThreadItems'
  );
  product.runtimeConfig = {
    createFile: refuse('product client must not create runtime config'),
    reload: refuse('product client must not reload runtime config'),
  };
  return { admin, adminCalls, core: product, productCalls };
}

/**
 * Applies URI component encoding repeatedly for worker-image adversarial inputs.
 *
 * @param {string} value Plain credential-shaped input.
 * @param {number} depth Exact encoding depth.
 * @returns {string} Repeatedly encoded input.
 */
function encodeWorkerImageLayers(value, depth) {
  let encoded = value;
  for (let pass = 0; pass < depth; pass += 1) {
    encoded = encodeURIComponent(encoded);
  }
  return encoded;
}

const INTERMEDIATE_WORKER_IMAGE_CASES = [
  {
    encoding: 'four-layer',
    name: 'query key',
    value: encodeWorkerImageLayers(
      'https://example.invalid/path?access_token=worker-image-four-canary',
      4
    ),
  },
  {
    encoding: 'five-layer',
    name: 'fragment key',
    value: encodeWorkerImageLayers(
      'https://example.invalid/path#client_secret=worker-image-five-canary',
      5
    ),
  },
  {
    encoding: 'six-layer',
    name: 'userinfo',
    value: encodeWorkerImageLayers('https://operator:worker-image-six-canary@example.invalid', 6),
  },
  {
    encoding: 'seven-layer',
    name: 'query key',
    value: encodeWorkerImageLayers(
      'https://example.invalid/path?access_token=worker-image-seven-canary',
      7
    ),
  },
];

const UNICODE_ESCAPED_NESTED_WORKER_IMAGE_CASES = [
  {
    description: 'nested JSON with a Unicode-escaped leading character in access_token',
    value: '{"\\u0061ccess_token":"worker-image-unicode-leading-canary"}',
  },
  {
    description: 'nested JSON with a Unicode-escaped separator in access_token',
    value: '{"access\\u005ftoken":"worker-image-unicode-separator-canary"}',
  },
];

describe('real Task Mode worker L3 test policy', () => {
  it('stays default-off without touching NanoCore', async () => {
    const result = await runTaskModeRealWorkerTest({
      env: {},
      fileExists: () => false,
      stdout: () => {},
    });

    assert.equal(result.status, 'skipped');
    assert.match(result.reason, /OPENKIT_L6_TASK_REAL_WORKER=1/);
  });

  it('requires quota acknowledgement and complete prerequisites', () => {
    const quotaDecision = evaluateTaskModeRealWorkerPrerequisites({
      env: { OPENKIT_L6_TASK_REAL_WORKER: '1' },
      fileExists: () => true,
    });
    assert.equal(quotaDecision.enabled, false);
    assert.match(quotaDecision.reason, /OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1/);

    const env = enabledTaskModeEnv();
    assert.equal(
      evaluateTaskModeRealWorkerPrerequisites({
        env: { ...env, OPENKIT_L6_TASK_WORKER_IMAGE_REF: '' },
        fileExists: () => true,
      }).enabled,
      false
    );
    assert.equal(
      evaluateTaskModeRealWorkerPrerequisites({ env, fileExists: () => true }).enabled,
      true
    );
    assert.equal(
      evaluateTaskModeRealWorkerPrerequisites({
        env: enabledTaskModeEnv({ OPENKIT_L6_TASK_GIT_COMMIT: 'a'.repeat(64) }),
      }).enabled,
      true
    );
    assert.equal(
      evaluateTaskModeRealWorkerPrerequisites({
        env: enabledTaskModeEnv({
          OPENKIT_NANOCORE_SESSION_COOKIE: 'product-session-canary',
          OPENKIT_NANOCORE_TOKEN: 'admin-token-canary',
        }),
      }).enabled,
      true
    );
  });

  it('sends fetchTaskModeRealWorker over App HTTP/1.1 and returns a WHATWG Response', async () => {
    const { fetchTaskModeRealWorker } = await import('./task-mode-real-worker-runner.mjs');
    const observed = {
      body: '',
      headers: /** @type {Record<string, string | undefined>} */ ({}),
      method: '',
      path: '',
    };
    const server = createHttpServer((request, response) => {
      observed.method = request.method ?? '';
      observed.path = request.url ?? '';
      observed.headers = {
        'content-type': request.headers['content-type'],
        'x-task-probe': request.headers['x-task-probe'],
      };
      const chunks = [];
      request.on('data', (chunk) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        observed.body = Buffer.concat(chunks).toString('utf8');
        response.writeHead(201, {
          'content-type': 'text/plain; charset=utf-8',
          'x-task-mode': 'h1-ok',
        });
        response.end('h1-response-body');
      });
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const response = await fetchTaskModeRealWorker(`http://127.0.0.1:${port}/task-mode-h1`, {
        method: 'POST',
        headers: new Headers({
          'content-type': 'application/json',
          'x-task-probe': 'real-h1',
        }),
        body: '{"probe":true}',
      });

      assert.equal(response instanceof Response, true);
      assert.equal(response.status, 201);
      assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.equal(response.headers.get('x-task-mode'), 'h1-ok');
      assert.equal(await response.text(), 'h1-response-body');
      assert.deepEqual(observed, {
        body: '{"probe":true}',
        headers: {
          'content-type': 'application/json',
          'x-task-probe': 'real-h1',
        },
        method: 'POST',
        path: '/task-mode-h1',
      });
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('rejects an AEP route that differs from the preflight-derived provider identity', async () => {
    const workerImageRef = 'example.invalid/openkit-worker:test';
    const fixture = createPassingTaskModeFixture({ workerImageRef });
    const aepRead = await fixture.clients.core.app.listAgentEnvironmentPackageSnapshots(
      fixture.ids.workspaceId
    );
    assert.throws(
      () =>
        assertTaskModeAgentEnvironment({
          aepRead,
          expectedGitCommit: TASK_MODE_GIT_COMMIT,
          expectedGitUrl: TASK_MODE_GIT_URL,
          expectedImageRef: workerImageRef,
          expectedProviderId: 'a1-openai-codex',
          packageSnapshotId: 'snapshot_acceptance',
          turnId: 'turn_acceptance',
        }),
      /provider or model/i
    );
  });

  it('pins the real Task worker to the catalog-resolved Git source and declared worktree', async () => {
    const workerImageRef = 'example.invalid/openkit-worker:test';
    const fixture = createPassingTaskModeFixture({ workerImageRef });
    const aepRead = await fixture.clients.core.app.listAgentEnvironmentPackageSnapshots(
      fixture.ids.workspaceId
    );
    const input = {
      aepRead,
      expectedGitCommit: TASK_MODE_GIT_COMMIT,
      expectedGitUrl: TASK_MODE_GIT_URL,
      expectedImageRef: workerImageRef,
      expectedProviderId: 'openai_codex',
      packageSnapshotId: 'snapshot_acceptance',
      turnId: 'turn_acceptance',
    };

    assert.doesNotThrow(() => assertTaskModeAgentEnvironment(input));
    for (const mutate of [
      (snapshot) => {
        snapshot.workspace.root = '/workspace/other';
      },
      (snapshot) => {
        snapshot.workspace.inputs[0].target = '/workspace/openkit/worktrees/other';
      },
      (snapshot) => {
        snapshot.workspace.inputs[0].source.url = 'https://git.example.test/other.git';
      },
      (snapshot) => {
        snapshot.workspace.inputs[0].source.commit = '0'.repeat(40);
      },
      (snapshot) => {
        snapshot.workspace.inputs[0].source.sourceRef = 'other-source';
      },
    ]) {
      const changedRead = structuredClone(aepRead);
      mutate(changedRead.items[0].snapshot);
      assert.throws(
        () => assertTaskModeAgentEnvironment({ ...input, aepRead: changedRead }),
        /workspace|Git|source/i
      );
    }
  });

  it('creates the fixed remote Git catalog before safe reload and product Task start', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-task-remote-git-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const workerImageRef = 'example.invalid/openkit-worker:test';
    const env = enabledTaskModeEnv({
      OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
    });
    const fixture = createPassingTaskModeFixture({ workerImageRef });
    const calls = [];
    const originalCreateWorkspace = fixture.clients.core.core.createWorkspace;
    fixture.clients.core.core.createWorkspace = async (...args) => {
      calls.push('createWorkspace');
      return originalCreateWorkspace(...args);
    };
    const originalCreateThread = fixture.clients.core.core.createThread;
    fixture.clients.core.core.createThread = async (...args) => {
      calls.push('createThread');
      return originalCreateThread(...args);
    };
    fixture.clients.admin.runtimeConfig.createFile = async (input) => {
      calls.push('createFile');
      assert.equal(input.id, `workspaces/${fixture.ids.workspaceId}/data-sources.jsonc`);
      assert.equal(input.kind, 'data-source');
      assert.deepEqual(JSON.parse(input.content), {
        schemaVersion: 1,
        sources: [
          {
            access: 'read-write',
            allowedSlotKinds: ['worktree'],
            displayName: 'Task Mode real worker repository',
            id: TASK_MODE_GIT_SOURCE_ID,
            kind: 'git',
            locator: { commit: TASK_MODE_GIT_COMMIT, url: TASK_MODE_GIT_URL },
            sensitivity: 'internal',
            status: 'active',
          },
        ],
      });
      return { diagnostics: [], file: { exists: true } };
    };
    fixture.clients.admin.runtimeConfig.reload = async (input) => {
      calls.push('reload');
      assert.deepEqual(input, { mode: 'safe' });
      return {
        plan: {
          applied: [],
          deferred: [{ path: 'workspaceDataSources' }],
          rejected: [],
          requiresRestart: [],
          warnings: [],
        },
        runtimeConfig: { pendingRestart: [] },
        status: 'applied',
      };
    };
    const originalStartTaskMode = fixture.clients.core.app.startTaskMode;
    fixture.clients.core.app.startTaskMode = async (...args) => {
      calls.push('startTaskMode');
      return originalStartTaskMode(...args);
    };

    try {
      const decision = evaluateTaskModeRealWorkerPrerequisites({
        env,
      });
      assert.equal(decision.enabled, true);

      const result = await runTaskModeRealWorkerTest({
        clients: fixture.clients,
        configureRuntime: async () => ({ providerId: 'openai_codex' }),
        env,
        stdout: () => {},
      });
      assert.equal(result.status, 'ok');
      assert.deepEqual(calls.slice(0, 5), [
        'createWorkspace',
        'createThread',
        'createFile',
        'reload',
        'startTaskMode',
      ]);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  for (const { description, plan } of [
    {
      description: 'omits workspaceDataSources from the deferred paths',
      plan: { deferred: [], rejected: [], requiresRestart: [] },
    },
    {
      description: 'duplicates one allowed deferred path',
      plan: {
        deferred: [{ path: 'workspaceDataSources' }, { path: 'workspaceDataSources' }],
        rejected: [],
        requiresRestart: [],
      },
    },
    {
      description: 'includes an unexpected deferred path',
      plan: {
        deferred: [{ path: 'workspaceDataSources' }, { path: 'agents' }],
        rejected: [],
        requiresRestart: [],
      },
    },
    {
      description: 'rejects the workspace data source change',
      plan: {
        deferred: [{ path: 'workspaceDataSources' }],
        rejected: [{ path: 'workspaceDataSources' }],
        requiresRestart: [],
      },
    },
    {
      description: 'requires a restart for the workspace data source change',
      plan: {
        deferred: [{ path: 'workspaceDataSources' }],
        rejected: [],
        requiresRestart: [{ path: 'workspaceDataSources' }],
      },
    },
  ]) {
    it(`refuses to start Task Mode when safe reload ${description}`, async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-task-remote-git-reload-'));
      const fixture = createPassingTaskModeFixture({
        workerImageRef: 'example.invalid/openkit-worker:test',
      });
      let startTaskModeCalls = 0;
      fixture.clients.admin.runtimeConfig.reload = async () => ({
        plan: { applied: [], warnings: [], ...plan },
        runtimeConfig: { pendingRestart: plan.requiresRestart },
        status: 'applied',
      });
      fixture.clients.core.app.startTaskMode = async () => {
        startTaskModeCalls += 1;
        return { evidence: { reviewIds: [] }, state: 'completed', turn: { id: 'turn_acceptance' } };
      };

      try {
        const failure = await runTaskModeRealWorkerTest({
          clients: fixture.clients,
          configureRuntime: async () => ({ providerId: 'openai_codex' }),
          env: enabledTaskModeEnv({
            OPENKIT_L6_EVIDENCE_DIR: join(tempRoot, 'evidence'),
          }),
          stdout: () => {},
        }).then(
          () => null,
          (error) => error
        );
        assert.equal(startTaskModeCalls, 0);
        assert.match(
          failure instanceof Error ? failure.message : '',
          /reload|workspace data source|restart/i
        );
      } finally {
        rmSync(tempRoot, { force: true, recursive: true });
      }
    });
  }

  for (const { backendVersion, description } of [
    { backendVersion: '0.0.80', description: 'OpenShell 0.0.80' },
    { backendVersion: undefined, description: 'a missing backend version' },
    { backendVersion: null, description: 'a null backend version' },
  ]) {
    it(`rejects ${description} for runtime provenance`, async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-task-backend-version-reject-'));
      const evidenceDir = join(tempRoot, 'evidence');
      const workerImageRef = 'example.invalid/openkit-worker:test';
      const fixture = createPassingTaskModeFixture({ workerImageRef });
      const originalListEvidence = fixture.clients.core.app.listWorkspaceRuntimeEvidence;
      fixture.clients.core.app.listWorkspaceRuntimeEvidence = async () => {
        const value = await originalListEvidence();
        return {
          runtimeEvidence: value.runtimeEvidence.map((record) => ({
            ...record,
            backendVersion,
          })),
        };
      };
      try {
        await assert.rejects(
          () =>
            runTaskModeRealWorkerTest({
              clients: fixture.clients,
              configureRuntime: async () => ({ providerId: 'openai_codex' }),
              env: enabledTaskModeEnv({
                OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
                OPENKIT_L6_TASK_WORKER_IMAGE_REF: workerImageRef,
              }),
              stdout: () => {},
            }),
          /0\.0\.99/
        );
      } finally {
        rmSync(tempRoot, { force: true, recursive: true });
      }
    });
  }

  it('requires OpenShell backend version 0.0.99', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-task-backend-version-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const workerImageRef = 'example.invalid/openkit-worker:test';
    const fixture = createPassingTaskModeFixture({ workerImageRef });
    const derivedProviderId = 'a1-openai-codex';
    const originalListAep = fixture.clients.core.app.listAgentEnvironmentPackageSnapshots;
    fixture.clients.core.app.listAgentEnvironmentPackageSnapshots = async (...args) => {
      const aepRead = await originalListAep(...args);
      aepRead.items[0].snapshot.llm.routes[0].providerInstanceId = derivedProviderId;
      return aepRead;
    };
    const originalListEvidence = fixture.clients.core.app.listWorkspaceRuntimeEvidence;
    fixture.clients.core.app.listWorkspaceRuntimeEvidence = async () => {
      const value = await originalListEvidence();
      return {
        runtimeEvidence: value.runtimeEvidence.map((record) => ({
          ...record,
          backendVersion: '0.0.99',
        })),
      };
    };
    try {
      const result = await runTaskModeRealWorkerTest({
        clients: fixture.clients,
        configureRuntime: async () => ({ providerId: derivedProviderId }),
        env: enabledTaskModeEnv({
          OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
          OPENKIT_L6_TASK_WORKER_IMAGE_REF: workerImageRef,
        }),
        stdout: () => {},
      });
      assert.equal(result.status, 'ok');
      assert.equal(result.provenance.backendType, 'openshell');
      assert.equal(result.provenance.backendVersion, '0.0.99');
      assert.equal(result.aep.providerId, derivedProviderId);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('uses the admin client only for preflight and diagnostics and the product client for Workspace execution', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-task-actor-split-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const workerImageRef = 'example.invalid/openkit-worker:test';
    const { admin, adminCalls, core, productCalls } = createDistinctTaskModeActorClients({
      reviewIds: ['review_acceptance'],
      workerImageRef,
    });
    try {
      const result = await runTaskModeRealWorkerTest({
        clients: { admin, core },
        configureRuntime: async (client) => {
          adminCalls.push('configureRuntime');
          assert.equal(client, admin);
          return { providerId: 'openai_codex' };
        },
        env: enabledTaskModeEnv({
          OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
          OPENKIT_L6_TASK_WORKER_IMAGE_REF: workerImageRef,
        }),
        stdout: () => {},
      });
      assert.equal(result.status, 'ok');
      assert.deepEqual(adminCalls, ['configureRuntime', 'getDiagnostics', 'createFile', 'reload']);
      assert.deepEqual(
        new Set(productCalls),
        new Set([
          'createThread',
          'createWorkspace',
          'getCapabilityUsage',
          'listAgentEnvironmentPackageSnapshots',
          'listThreadItems',
          'listWorkspaceRuntimeEvidence',
          'startTaskMode',
          'submitWorkspaceSyncReviewDecision',
        ])
      );
      assert.deepEqual(productCalls.slice(0, 3), [
        'createWorkspace',
        'createThread',
        'startTaskMode',
      ]);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('rejects a swapped admin and product client pair', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-task-actor-swap-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const workerImageRef = 'example.invalid/openkit-worker:test';
    const { admin, core } = createDistinctTaskModeActorClients({ workerImageRef });
    try {
      await assert.rejects(
        () =>
          runTaskModeRealWorkerTest({
            clients: { admin: core, core: admin },
            configureRuntime: async () => ({ providerId: 'openai_codex' }),
            env: enabledTaskModeEnv({
              OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
              OPENKIT_L6_TASK_WORKER_IMAGE_REF: workerImageRef,
            }),
            stdout: () => {},
          }),
        /must not/
      );
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('constructs distinct admin and product clients from separate header factories', async () => {
    const constructed = [];
    const createClient = (options) => {
      const client = { options };
      constructed.push(client);
      return client;
    };
    const config = {
      nanoCoreUrl: 'http://127.0.0.1:3000',
      sessionCookie: 'product-session-canary',
      token: 'admin-token-canary',
    };
    const clients = await createRealClients(config, createClient);
    assert.equal(constructed.length, 2);
    assert.notEqual(clients.admin, clients.core);
    assert.deepEqual(new Set(constructed), new Set([clients.admin, clients.core]));
    assert.deepEqual(clients.admin.options, {
      baseUrl: config.nanoCoreUrl,
      fetch: fetchTaskModeRealWorker,
      headers: {
        authorization: 'Bearer admin-token-canary',
        'x-openkit-client-channel': 'core-client',
        'x-openkit-client-source': 'desktop-agent',
      },
    });
    assert.deepEqual(clients.core.options, {
      baseUrl: config.nanoCoreUrl,
      fetch: fetchTaskModeRealWorker,
      headers: {
        cookie: 'product-session-canary',
        'x-openkit-client-channel': 'core-client',
        'x-openkit-client-source': 'desktop-agent',
      },
    });
    assert.equal('cookie' in clients.admin.options.headers, false);
    assert.equal('authorization' in clients.core.options.headers, false);
  });

  it('reuses one unauthenticated client when both secrets are absent', async () => {
    const constructed = [];
    const createClient = (options) => {
      const client = { options };
      constructed.push(client);
      return client;
    };
    const clients = await createRealClients({ nanoCoreUrl: 'http://127.0.0.1:3000' }, createClient);
    assert.equal(constructed.length, 1);
    assert.equal(clients.admin, clients.core);
    assert.equal(clients.admin, constructed[0]);
    assert.deepEqual(clients.admin.options, {
      baseUrl: 'http://127.0.0.1:3000',
      fetch: fetchTaskModeRealWorker,
    });
  });

  it('retains the exact product commit and host-manifest digest without weakening redaction', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-task-evidence-identity-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const workerImageRef = 'example.invalid/openkit-worker:test';
    const tokenCanary = 'task-result-token-canary-value';
    const cookieCanary = 'task-result-cookie-canary-value';
    const { clients } = createPassingTaskModeFixture({ workerImageRef });

    try {
      const result = await runTaskModeRealWorkerTest({
        clients,
        configureRuntime: async () => ({ providerId: 'openai_codex' }),
        env: enabledTaskModeEnv({
          OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
          OPENKIT_L6_TASK_NANOCORE_URL: 'http://127.0.0.1:3000/private/nanocore/path?view=debug',
          OPENKIT_L6_TASK_WORKER_IMAGE_REF: workerImageRef,
          OPENKIT_NANOCORE_SESSION_COOKIE: cookieCanary,
          OPENKIT_NANOCORE_TOKEN: tokenCanary,
        }),
        stdout: () => {},
      });
      const serialized = JSON.stringify(result);
      assert.equal(result.status, 'ok');
      assert.equal(result.productCommit, TASK_MODE_PRODUCT_COMMIT);
      assert.match(result.productCommit, /^[a-f0-9]{40}$/);
      assert.equal(result.hostManifestDigest, TASK_MODE_HOST_MANIFEST_DIGEST);
      assert.match(result.hostManifestDigest, /^[a-f0-9]{64}$/);
      assert.equal(result.config.nanoCoreUrl, 'http://127.0.0.1:3000');
      assert.equal(result.config.tokenProvided, true);
      assert.equal(result.config.sessionCookieProvided, true);
      assert.equal(serialized.includes(tokenCanary), false);
      assert.equal(serialized.includes(cookieCanary), false);
      assert.equal(serialized.includes('localPath'), false);
      assert.equal(serialized.includes('?view=debug'), false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  for (const { description, patch, reasonPattern } of [
    {
      description: 'a missing Git URL',
      patch: { OPENKIT_L6_TASK_GIT_URL: '' },
      reasonPattern: /Git URL|OPENKIT_L6_TASK_GIT_URL/i,
    },
    {
      description: 'a missing Git commit',
      patch: { OPENKIT_L6_TASK_GIT_COMMIT: '' },
      reasonPattern: /Git commit|OPENKIT_L6_TASK_GIT_COMMIT/i,
    },
    {
      description: 'a non-HTTPS Git URL',
      patch: { OPENKIT_L6_TASK_GIT_URL: 'http://git.example.test/openkit/repository.git' },
      reasonPattern: /Git URL|OPENKIT_L6_TASK_GIT_URL/i,
    },
    {
      description: 'a credential-bearing Git URL',
      patch: {
        OPENKIT_L6_TASK_GIT_URL: 'https://operator@git.example.test/openkit/repository.git',
      },
      reasonPattern: /Git URL|OPENKIT_L6_TASK_GIT_URL/i,
    },
    {
      description: 'a query-bearing Git URL',
      patch: {
        OPENKIT_L6_TASK_GIT_URL:
          'https://git.example.test/openkit/repository.git?ref=task-query-canary',
      },
      reasonPattern: /Git URL|OPENKIT_L6_TASK_GIT_URL/i,
    },
    {
      description: 'a fragment-bearing Git URL',
      patch: {
        OPENKIT_L6_TASK_GIT_URL:
          'https://git.example.test/openkit/repository.git#task-fragment-canary',
      },
      reasonPattern: /Git URL|OPENKIT_L6_TASK_GIT_URL/i,
    },
    {
      description: 'a wrong-length Git commit',
      patch: { OPENKIT_L6_TASK_GIT_COMMIT: TASK_MODE_GIT_COMMIT.slice(0, 39) },
      reasonPattern: /Git commit|OPENKIT_L6_TASK_GIT_COMMIT/i,
    },
    {
      description: 'a non-lowercase Git commit',
      patch: { OPENKIT_L6_TASK_GIT_COMMIT: TASK_MODE_GIT_COMMIT.toUpperCase() },
      reasonPattern: /Git commit|OPENKIT_L6_TASK_GIT_COMMIT/i,
    },
    {
      description: 'a non-hex Git commit',
      patch: { OPENKIT_L6_TASK_GIT_COMMIT: 'g'.repeat(40) },
      reasonPattern: /Git commit|OPENKIT_L6_TASK_GIT_COMMIT/i,
    },
    { description: 'a missing product commit', patch: { OPENKIT_L6_TASK_PRODUCT_COMMIT: '' } },
    {
      description: 'a missing host-manifest digest',
      patch: { OPENKIT_L6_TASK_HOST_MANIFEST_DIGEST: '' },
    },
    {
      description: 'a wrong-length product commit',
      patch: { OPENKIT_L6_TASK_PRODUCT_COMMIT: TASK_MODE_PRODUCT_COMMIT.slice(0, 39) },
    },
    {
      description: 'a wrong-length host-manifest digest',
      patch: { OPENKIT_L6_TASK_HOST_MANIFEST_DIGEST: TASK_MODE_HOST_MANIFEST_DIGEST.slice(0, 63) },
    },
    {
      description: 'a non-lowercase product commit',
      patch: { OPENKIT_L6_TASK_PRODUCT_COMMIT: TASK_MODE_PRODUCT_COMMIT.toUpperCase() },
    },
    {
      description: 'a non-lowercase host-manifest digest',
      patch: { OPENKIT_L6_TASK_HOST_MANIFEST_DIGEST: TASK_MODE_HOST_MANIFEST_DIGEST.toUpperCase() },
    },
    {
      description: 'a non-hex product commit',
      patch: { OPENKIT_L6_TASK_PRODUCT_COMMIT: 'g'.repeat(40) },
    },
    {
      description: 'a non-hex host-manifest digest',
      patch: { OPENKIT_L6_TASK_HOST_MANIFEST_DIGEST: 'g'.repeat(64) },
    },
    {
      description: 'a token without a session cookie',
      patch: { OPENKIT_NANOCORE_TOKEN: 'admin-token-canary' },
    },
    {
      description: 'a session cookie without a token',
      patch: { OPENKIT_NANOCORE_SESSION_COOKIE: 'product-session-canary' },
    },
    {
      description: 'a session cookie containing CR',
      patch: {
        OPENKIT_NANOCORE_SESSION_COOKIE: 'product-session\rcanary',
        OPENKIT_NANOCORE_TOKEN: 'admin-token-canary',
      },
    },
    {
      description: 'a session cookie containing LF',
      patch: {
        OPENKIT_NANOCORE_SESSION_COOKIE: 'product-session\ncanary',
        OPENKIT_NANOCORE_TOKEN: 'admin-token-canary',
      },
    },
    {
      description: 'a token containing CR',
      patch: {
        OPENKIT_NANOCORE_SESSION_COOKIE: 'product-session-canary',
        OPENKIT_NANOCORE_TOKEN: 'admin-token\rcanary',
      },
    },
    {
      description: 'a token containing LF',
      patch: {
        OPENKIT_NANOCORE_SESSION_COOKIE: 'product-session-canary',
        OPENKIT_NANOCORE_TOKEN: 'admin-token\ncanary',
      },
    },
    {
      description: 'a whitespace-only token',
      patch: { OPENKIT_NANOCORE_TOKEN: '   ' },
    },
    {
      description: 'a whitespace-only session cookie',
      patch: { OPENKIT_NANOCORE_SESSION_COOKIE: '\t\t' },
    },
    {
      description: 'whitespace-only token and session cookie',
      patch: {
        OPENKIT_NANOCORE_SESSION_COOKIE: ' \t ',
        OPENKIT_NANOCORE_TOKEN: '  ',
      },
    },
  ]) {
    it(`rejects ${description} before createClients, configureRuntime, and startTaskMode`, async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-task-identity-reject-'));
      const env = enabledTaskModeEnv({
        ...patch,
        OPENKIT_L6_EVIDENCE_DIR: join(tempRoot, 'evidence'),
      });
      const fixture = createPassingTaskModeFixture({
        workerImageRef: env.OPENKIT_L6_TASK_WORKER_IMAGE_REF,
      });
      let createClientsCalls = 0;
      let createFileCalls = 0;
      let configureRuntimeCalls = 0;
      let reloadCalls = 0;
      let startTaskModeCalls = 0;
      const stdout = [];
      fixture.clients.admin.runtimeConfig.createFile = async () => {
        createFileCalls += 1;
      };
      fixture.clients.admin.runtimeConfig.reload = async () => {
        reloadCalls += 1;
      };
      fixture.clients.core.app.startTaskMode = async () => {
        startTaskModeCalls += 1;
        return {
          evidence: { reviewIds: [] },
          state: 'completed',
          turn: { id: 'turn_acceptance' },
        };
      };

      try {
        const decision = evaluateTaskModeRealWorkerPrerequisites({ env });
        assert.equal(decision.enabled, false);
        if (reasonPattern) {
          assert.match(decision.reason, reasonPattern);
        }
        const outcome = await runTaskModeRealWorkerTest({
          createClients: async () => {
            createClientsCalls += 1;
            return fixture.clients;
          },
          configureRuntime: async () => {
            configureRuntimeCalls += 1;
            return { providerId: 'openai_codex' };
          },
          env,
          fileExists: () => true,
          stdout: (message) => stdout.push(message),
        }).then(
          (result) => result.status,
          () => 'rejected'
        );

        assert.equal(['rejected', 'skipped'].includes(outcome), true);
        assert.deepEqual(
          {
            configureRuntimeCalls,
            createClientsCalls,
            createFileCalls,
            reloadCalls,
            startTaskModeCalls,
          },
          {
            configureRuntimeCalls: 0,
            createClientsCalls: 0,
            createFileCalls: 0,
            reloadCalls: 0,
            startTaskModeCalls: 0,
          }
        );
        if (description.includes('query-bearing') || description.includes('fragment-bearing')) {
          assert.equal(stdout.join('\n').includes('task-query-canary'), false);
          assert.equal(stdout.join('\n').includes('task-fragment-canary'), false);
          assert.equal(existsSync(env.OPENKIT_L6_EVIDENCE_DIR), false);
        }
      } finally {
        rmSync(tempRoot, { force: true, recursive: true });
      }
    });
  }

  it('keeps the real CLI path on one fixed deadline and the shared supervision owners', () => {
    const runnerSource = readFileSync(
      new URL('./task-mode-real-worker-runner.mjs', import.meta.url),
      'utf8'
    );
    const deadlineMatch = runnerSource.match(/const TASK_MODE_REAL_WORKER_TIMEOUT_MS = ([\d_]+);/);

    assert.notEqual(deadlineMatch, null);
    const deadlineMs = Number(deadlineMatch[1].replaceAll('_', ''));
    assert.equal(Number.isSafeInteger(deadlineMs) && deadlineMs > 0, true);
    assert.match(
      runnerSource,
      /import \{[\s\S]*\bassertNoPublicSecretLeak\b[\s\S]*\bwaitForChildOrDeadline\b[\s\S]*\} from '\.\/_lib\/real-codex-support\.mjs';/
    );
    assert.match(
      runnerSource,
      /waitForChildOrDeadline\(\s*child,\s*TASK_MODE_REAL_WORKER_TIMEOUT_MS,\s*options\.killProcess \?\? process\.kill\s*\)/
    );
    assert.match(
      runnerSource,
      /if \(process\.argv\[2\] === SUPERVISED_CHILD_ARG\) \{\s*runTaskModeRealWorkerTest\(\)/
    );
    assert.match(runnerSource, /else \{\s*runTaskModeRealWorkerCli\(\)\.catch/);
  });

  for (const encodedWorkerImage of [
    {
      encoding: 'normal',
      name: 'userinfo',
      value: 'https://operator:worker-image-normal-canary@example.invalid',
    },
    {
      encoding: 'single',
      name: 'query key',
      value: encodeWorkerImageLayers(
        'https://example.invalid/path?access_token=worker-image-single-canary',
        1
      ),
    },
    {
      encoding: 'double',
      name: 'userinfo',
      value: 'https%253A%252F%252Foperator%253Aworker-image-userinfo-canary%2540example.invalid',
    },
    {
      encoding: 'double',
      name: 'query key',
      value: 'example.invalid/openkit-worker:test?access%255Ftoken=worker-image-query-canary',
    },
    {
      encoding: 'double',
      name: 'fragment key',
      value: 'example.invalid/openkit-worker:test#client%255Fsecret=worker-image-fragment-canary',
    },
    {
      encoding: 'triple',
      name: 'userinfo',
      value:
        'https%25253A%25252F%25252Foperator%25253Aworker-image-userinfo-canary%252540example.invalid',
    },
    {
      encoding: 'triple',
      name: 'query key',
      value: 'example.invalid/openkit-worker:test?access%25255Ftoken=worker-image-query-canary',
    },
    {
      encoding: 'triple',
      name: 'fragment key',
      value: 'example.invalid/openkit-worker:test#client%25255Fsecret=worker-image-fragment-canary',
    },
    ...INTERMEDIATE_WORKER_IMAGE_CASES,
    {
      encoding: 'eight-layer',
      name: 'fragment key',
      value: encodeWorkerImageLayers(
        'https://example.invalid/path#client_secret=worker-image-eight-canary',
        8
      ),
    },
    {
      encoding: 'nine-layer',
      name: 'userinfo',
      value: encodeWorkerImageLayers(
        'https://operator:worker-image-nine-canary@example.invalid',
        9
      ),
    },
    ...UNICODE_ESCAPED_NESTED_WORKER_IMAGE_CASES,
  ]) {
    const workerImageDescription =
      encodedWorkerImage.description ??
      `${encodedWorkerImage.encoding}-percent-encoded ${encodedWorkerImage.name}`;
    it(`rejects ${workerImageDescription} in workerImageRef without failure evidence`, async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-task-failure-evidence-'));
      const evidenceDir = join(tempRoot, 'evidence');
      const secretCanary = 'task-failure-secret-canary';

      try {
        await assert.rejects(
          () =>
            runTaskModeRealWorkerTest({
              clients: { core: {} },
              configureRuntime: async () => {
                throw new Error(secretCanary);
              },
              env: enabledTaskModeEnv({
                OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
                OPENKIT_L6_TASK_WORKER_IMAGE_REF: encodedWorkerImage.value,
              }),
              stdout: () => {},
            }),
          new RegExp(secretCanary)
        );

        const failurePath = join(evidenceDir, 'task-mode-real-worker-failure.json');
        const resultPath = join(evidenceDir, 'task-mode-real-worker-result.json');
        assert.deepEqual(
          {
            failureEvidenceExists: existsSync(failurePath),
            resultEvidenceExists: existsSync(resultPath),
          },
          {
            failureEvidenceExists: false,
            resultEvidenceExists: false,
          }
        );
      } finally {
        rmSync(tempRoot, { force: true, recursive: true });
      }
    });
  }

  it('projects the NanoCore URL to its origin only in failure evidence', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-task-url-redaction-'));
    const evidenceDir = join(tempRoot, 'evidence');

    try {
      await assert.rejects(
        () =>
          runTaskModeRealWorkerTest({
            clients: { core: {} },
            configureRuntime: async () => {
              throw new Error('Forced runtime verification failure.');
            },
            env: enabledTaskModeEnv({
              OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
              OPENKIT_L6_TASK_NANOCORE_URL:
                'http://127.0.0.1:3000/private/nanocore/path?view=debug#operator',
              OPENKIT_NANOCORE_SESSION_COOKIE: 'task-failure-cookie-canary-value',
              OPENKIT_NANOCORE_TOKEN: 'task-failure-token-canary-value',
            }),
            stdout: () => {},
          }),
        /Forced runtime verification failure/
      );

      const failurePath = join(evidenceDir, 'task-mode-real-worker-failure.json');
      const failureEvidence = JSON.parse(readFileSync(failurePath, 'utf8'));
      const failureText = readFileSync(failurePath, 'utf8');
      assert.equal(failureEvidence.config.nanoCoreUrl, 'http://127.0.0.1:3000');
      assert.equal(failureEvidence.config.tokenProvided, true);
      assert.equal(failureEvidence.config.sessionCookieProvided, true);
      assert.equal(failureText.includes('task-failure-cookie-canary-value'), false);
      assert.equal(failureText.includes('task-failure-token-canary-value'), false);
      assert.equal(failureText.includes('?view=debug#operator'), false);
      assert.equal(failureText.includes('localPath'), false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('writes the failed Turn product-safe runtime evidence into failure evidence', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-task-runtime-failure-evidence-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const workerImageRef = 'example.invalid/openkit-worker:test';
    const fixture = createPassingTaskModeFixture({ workerImageRef });
    const listed = await fixture.clients.core.app.listWorkspaceRuntimeEvidence();
    const turnEvidence = listed.runtimeEvidence[0];
    let runtimeEvidenceCalls = 0;
    fixture.clients.core.app.listWorkspaceRuntimeEvidence = async () => {
      runtimeEvidenceCalls += 1;
      return { runtimeEvidence: [turnEvidence, { ...turnEvidence, turnId: 'turn_other' }] };
    };
    fixture.clients.core.app.startTaskMode = async () => ({
      evidence: { reviewIds: [] },
      state: 'failed',
      turn: { id: turnEvidence.turnId },
    });

    try {
      await assert.rejects(
        () =>
          runTaskModeRealWorkerTest({
            clients: fixture.clients,
            configureRuntime: async () => ({ providerId: 'openai_codex' }),
            env: enabledTaskModeEnv({
              OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
              OPENKIT_L6_TASK_WORKER_IMAGE_REF: workerImageRef,
            }),
            stdout: () => {},
          }),
        /non-acceptance state: failed/
      );

      const failureEvidence = JSON.parse(
        readFileSync(join(evidenceDir, 'task-mode-real-worker-failure.json'), 'utf8')
      );
      assert.equal(runtimeEvidenceCalls, 1);
      assert.deepEqual(failureEvidence.runtimeEvidence, [turnEvidence]);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('reuses one runtime evidence read when a parallel Task diagnostic fails', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-task-runtime-evidence-race-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const workerImageRef = 'example.invalid/openkit-worker:test';
    const fixture = createPassingTaskModeFixture({ workerImageRef });
    const listed = await fixture.clients.core.app.listWorkspaceRuntimeEvidence();
    let runtimeEvidenceCalls = 0;
    fixture.clients.core.app.listWorkspaceRuntimeEvidence = async () => {
      runtimeEvidenceCalls += 1;
      return listed;
    };
    const originalFailure = new Error('Product thread diagnostic failed.');
    fixture.clients.core.core.listThreadItems = async () => {
      throw originalFailure;
    };

    try {
      await assert.rejects(
        () =>
          runTaskModeRealWorkerTest({
            clients: fixture.clients,
            configureRuntime: async () => ({ providerId: 'openai_codex' }),
            env: enabledTaskModeEnv({
              OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
              OPENKIT_L6_TASK_WORKER_IMAGE_REF: workerImageRef,
            }),
            stdout: () => {},
          }),
        (error) => error === originalFailure
      );
      const failureEvidence = JSON.parse(
        readFileSync(join(evidenceDir, 'task-mode-real-worker-failure.json'), 'utf8')
      );
      assert.equal(runtimeEvidenceCalls, 1);
      assert.deepEqual(failureEvidence.runtimeEvidence, listed.runtimeEvidence);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('preserves the Task failure when its runtime evidence read also fails', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-task-runtime-evidence-reject-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const workerImageRef = 'example.invalid/openkit-worker:test';
    const fixture = createPassingTaskModeFixture({ workerImageRef });
    let runtimeEvidenceCalls = 0;
    fixture.clients.core.app.listWorkspaceRuntimeEvidence = async () => {
      runtimeEvidenceCalls += 1;
      throw new Error('Runtime evidence read failed.');
    };
    fixture.clients.core.app.startTaskMode = async () => ({
      evidence: { reviewIds: [] },
      state: 'failed',
      turn: { id: 'turn_acceptance' },
    });

    try {
      await assert.rejects(
        () =>
          runTaskModeRealWorkerTest({
            clients: fixture.clients,
            configureRuntime: async () => ({ providerId: 'openai_codex' }),
            env: enabledTaskModeEnv({
              OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
              OPENKIT_L6_TASK_WORKER_IMAGE_REF: workerImageRef,
            }),
            stdout: () => {},
          }),
        /non-acceptance state: failed/
      );
      const failureEvidence = JSON.parse(
        readFileSync(join(evidenceDir, 'task-mode-real-worker-failure.json'), 'utf8')
      );
      assert.equal(runtimeEvidenceCalls, 1);
      assert.deepEqual(failureEvidence.runtimeEvidence, []);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  for (const encodedWorkerImage of [
    {
      encoding: 'normal',
      name: 'userinfo',
      value: 'https://operator:worker-image-success-normal-canary@example.invalid',
    },
    {
      encoding: 'single',
      name: 'query key',
      value: encodeWorkerImageLayers(
        'https://example.invalid/path?access_token=worker-image-success-single-canary',
        1
      ),
    },
    {
      encoding: 'double',
      name: 'fragment key',
      value: 'example.invalid/openkit-worker:test#client%255Fsecret=worker-image-success-canary',
    },
    {
      encoding: 'triple',
      name: 'userinfo',
      value:
        'https%25253A%25252F%25252Foperator%25253Aworker-image-success-canary%252540example.invalid',
    },
    {
      encoding: 'triple',
      name: 'query key',
      value: 'example.invalid/openkit-worker:test?access%25255Ftoken=worker-image-success-canary',
    },
    {
      encoding: 'triple',
      name: 'fragment key',
      value: 'example.invalid/openkit-worker:test#client%25255Fsecret=worker-image-success-canary',
    },
    ...INTERMEDIATE_WORKER_IMAGE_CASES,
    {
      encoding: 'eight-layer',
      name: 'fragment key',
      value: encodeWorkerImageLayers(
        'https://example.invalid/path#client_secret=worker-image-success-eight-canary',
        8
      ),
    },
    {
      encoding: 'nine-layer',
      name: 'userinfo',
      value: encodeWorkerImageLayers(
        'https://operator:worker-image-success-nine-canary@example.invalid',
        9
      ),
    },
    ...UNICODE_ESCAPED_NESTED_WORKER_IMAGE_CASES,
  ]) {
    const workerImageDescription =
      encodedWorkerImage.description ??
      `${encodedWorkerImage.encoding}-percent-encoded ${encodedWorkerImage.name}`;
    it(`rejects ${workerImageDescription} in workerImageRef without success evidence`, async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-task-success-image-redaction-'));
      const evidenceDir = join(tempRoot, 'evidence');
      const workerImageRef = encodedWorkerImage.value;
      const { clients } = createPassingTaskModeFixture({ workerImageRef });
      try {
        await assert.rejects(
          () =>
            runTaskModeRealWorkerTest({
              clients,
              configureRuntime: async () => ({ providerId: 'openai_codex' }),
              env: enabledTaskModeEnv({
                OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
                OPENKIT_L6_TASK_WORKER_IMAGE_REF: workerImageRef,
              }),
              stdout: () => {},
            }),
          /exposed/i
        );
        assert.deepEqual(
          {
            failureEvidenceExists: existsSync(
              join(evidenceDir, 'task-mode-real-worker-failure.json')
            ),
            resultEvidenceExists: existsSync(
              join(evidenceDir, 'task-mode-real-worker-result.json')
            ),
          },
          {
            failureEvidenceExists: false,
            resultEvidenceExists: false,
          }
        );
      } finally {
        rmSync(tempRoot, { force: true, recursive: true });
      }
    });
  }

  for (const reviewPath of ['success', 'assertion failure']) {
    it(`rejects every returned workspace review after ${reviewPath}`, async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-task-review-cleanup-'));
      const evidenceDir = join(tempRoot, 'evidence');
      const reviewId = `review_${reviewPath.replace(' ', '_')}`;
      const reviewCalls = [];
      const workerImageRef = 'example.invalid/openkit-worker:test';
      const fixture = createPassingTaskModeFixture({
        onReviewDecision: (workspaceId, receivedReviewId, input) => {
          reviewCalls.push({ input, reviewId: receivedReviewId, workspaceId });
        },
        reviewIds: [reviewId],
        workerImageRef,
      });
      if (reviewPath === 'assertion failure') {
        fixture.clients.core.app.getCapabilityUsage = async () => ({
          capabilityCalls: [],
          usageRecords: [],
        });
      }

      try {
        const run = () =>
          runTaskModeRealWorkerTest({
            clients: fixture.clients,
            configureRuntime: async () => ({ providerId: 'openai_codex' }),
            env: enabledTaskModeEnv({
              OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
              OPENKIT_L6_TASK_WORKER_IMAGE_REF: workerImageRef,
            }),
            stdout: () => {},
          });

        if (reviewPath === 'assertion failure') {
          await assert.rejects(run, /Capability ledger did not match/);
        } else {
          const result = await run();
          assert.equal(result.status, 'ok');
        }
        assert.deepEqual(
          reviewCalls.map((call) => ({
            decision: call.input.decision,
            requestIdProvided:
              typeof call.input.requestId === 'string' && call.input.requestId.length > 0,
            reviewId: call.reviewId,
            workspaceId: call.workspaceId,
          })),
          [
            {
              decision: 'rejected',
              requestIdProvided: true,
              reviewId,
              workspaceId: fixture.ids.workspaceId,
            },
          ]
        );
      } finally {
        rmSync(tempRoot, { force: true, recursive: true });
      }
    });
  }
});
