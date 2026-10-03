import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  seedDemoWorkspaceAuthority,
  seedDemoWorkspaceDataRoot as seedSharedDemoWorkspaceDataRoot,
} from '../../../../tests/support/demo-data.mjs';

/**
 * Writes the explicit Demo Workspace fixture used by local-mode Web e2e tests.
 *
 * @param dataRoot NanoCore data root to seed.
 * @returns Resolves after the file records and Core membership authority are durable.
 * @throws When fixture files or authority persistence fails.
 */
export async function seedDemoWorkspaceDataRoot(dataRoot: string): Promise<void> {
  seedSharedDemoWorkspaceDataRoot(dataRoot);
  await seedSimulatorInferenceConfig(dataRoot);
  await seedDemoWorkspaceAuthority(dataRoot);
  await seedSimulatorAgent(dataRoot);
}

/**
 * Installs the secret-free provider profile and logical Gateway route resolved by the simulator Agent fixture.
 *
 * @param dataRoot NanoCore data root to seed.
 * @returns Resolves after the provider profile and Gateway route are durable.
 * @throws When the config directory, provider profile, or Gateway route cannot be written.
 */
async function seedSimulatorInferenceConfig(dataRoot: string): Promise<void> {
  const providersRoot = join(dataRoot, 'config', 'providers');
  await mkdir(providersRoot, { recursive: true });
  await writeFile(
    join(providersRoot, 'agent-openrouter.provider.jsonc'),
    `${JSON.stringify(
      {
        id: 'agent-openrouter',
        displayName: 'Agent OpenRouter test local',
        kind: 'local',
        defaultModel: 'openai/gpt-5.2',
        models: ['openai/gpt-5.2'],
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(dataRoot, 'config', 'gateway.jsonc'),
    `${JSON.stringify(
      {
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
                id: 'simulator',
                providerProfileId: 'agent-openrouter',
                providerModel: 'openai/gpt-5.2',
              },
            ],
          },
        ],
        requiredFeatures: [],
        extensions: {},
      },
      null,
      2
    )}\n`
  );
}

/**
 * Installs the isolated self-check scheduler RuntimeTarget used by SimulatedTurnExecutor.
 *
 * This is fixture-only synthetic Epoch authority: `physicalEpoch` is `'a'.repeat(64)`, identity is
 * `identity_local`, and no NanoHost observation or real-host connection is claimed. Production
 * backend-session guards stay unchanged. Mirrors `configureLocalSchedulerCapacity` target setup in
 * `apps/nanocore/src/lib/simulator.test.ts`.
 *
 * Call after Core startup, which invalidates the previous physical generation.
 *
 * @param dataRoot Disposable NanoCore data root whose Core startup has completed.
 * @returns Resolves after `target_local` is ready and the local scheduler baseline exists.
 * @throws When Core storage, layout marker, allocation, or readiness projection fails.
 */
export async function seedSyntheticLocalSchedulerTarget(dataRoot: string): Promise<void> {
  const [
    { openCoreDb },
    { readDataRootLayoutMarker },
    { allocateNanoHostRuntimeTargetConnectionGeneration, upsertNanoHostRuntimeTarget },
    { ensureConfiguredSchedulerBaseline },
  ] = await Promise.all([
    import('../../../nanocore/dist/storage/db.js'),
    import('../../../nanocore/dist/storage/fs-layout.js'),
    import('../../../nanocore/dist/runtime/nanohost-runtime-target.js'),
    import('../../../nanocore/dist/scheduler-records.js'),
  ]);
  const coreDb = openCoreDb(dataRoot);

  try {
    const observedAt = new Date().toISOString();
    const runtimeTarget = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: readDataRootLayoutMarker(coreDb.dataRoot).deploymentId,
      identityId: 'identity_local',
      observedAt,
      targetId: 'target_local',
    });
    upsertNanoHostRuntimeTarget(coreDb, {
      ...runtimeTarget,
      freshEmpty: true,
      observedAt,
      physicalEpoch: 'a'.repeat(64),
      predecessorFenced: true,
      ready: true,
    });
    ensureConfiguredSchedulerBaseline(coreDb, { placement: 'local' });
  } finally {
    coreDb.sqlite.close();
  }
}

/**
 * Installs one resolvable non-simulator Agent manifest for the internal simulator executor.
 *
 * The simulator remains the executor; explicit synthetic image/default evidence satisfies the production Agent setup resolution boundary without claiming real image qualification.
 *
 * @param dataRoot NanoCore data root to seed.
 * @returns Resolves after the manifest and confirmed synthetic image defaults are durable.
 * @throws When the manifest or production settlement/admission writes fail.
 */
async function seedSimulatorAgent(dataRoot: string): Promise<void> {
  const runtimeImage = {
    kind: 'reference',
    ref: 'openkit/worker-codex:dev',
    pullPolicy: 'if-not-present',
  };
  const agentsRoot = join(dataRoot, 'config', 'agents');
  await mkdir(agentsRoot, { recursive: true });
  await writeFile(
    join(agentsRoot, 'codex.agent.jsonc'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        requiredFeatures: [],
        id: 'agent_codex_host',
        displayName: 'Codex Agent',
        runtime: {
          kind: 'codex',
          adapter: 'codex',
          version: 'test',
          image: runtimeImage,
          binaries: [
            { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
            { id: 'node', path: '/usr/local/bin/node' },
            { id: 'codex', path: '/usr/local/bin/codex' },
          ],
        },
        models: {
          preferredLogicalModelId: 'reasoning',
          allowedLogicalModelIds: ['reasoning'],
        },
        profiles: [{ id: 'default', instructionsRef: 'codex', skills: [] }],
        defaultProfileId: 'default',
        skills: [],
        mcp: [],
        sandbox: {
          backend: {
            allowedKinds: ['openshell'],
            preferred: 'openshell',
            requiredCapabilities: ['trusted-worker-inference-relay'],
          },
          credentialDeclarations: [],
          filesystem: [],
          network: [],
        },
      },
      null,
      2
    )}\n`
  );
  // Match the Worker MCP smoke's confirmed synthetic image seam; production admission remains enabled.
  const [
    { openCoreDb },
    { commandInputHash },
    { admitWorkerImageEnvironment, writeWorkerImageSettlement },
  ] = await Promise.all([
    import('../../../nanocore/dist/storage/db.js'),
    import('../../../nanocore/dist/runtime/idempotent-command.js'),
    import('../../../nanocore/dist/runtime/worker-image-settlements.js'),
  ]);
  const coreDb = openCoreDb(dataRoot);
  try {
    const inputDigest = commandInputHash(runtimeImage);
    const requestId = createHash('sha256').update(`web-e2e:${inputDigest}`).digest('hex');
    const imageDigest = `sha256:${'a'.repeat(64)}`;
    const candidate = {
      authoredArtifactId: `ar_web_e2e_${requestId}`,
      authoredArtifactVersion: 1 as const,
      authoredContentDigest: inputDigest,
      inputDigest,
    };
    writeWorkerImageSettlement(coreDb, {
      ...candidate,
      requestId,
      operation: 'image.acquire',
      outcome: { kind: 'success', imageDigest },
    });
    admitWorkerImageEnvironment(coreDb, candidate, {
      imageDigest,
      defaultsDigest: `sha256:${createHash('sha256').update('{}').digest('hex')}`,
      values: {},
    });
  } finally {
    coreDb.sqlite.close();
  }
}
