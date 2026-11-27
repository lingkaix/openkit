import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  seedDemoWorkspaceAuthority,
  seedDemoWorkspaceDataRoot as seedSharedDemoWorkspaceDataRoot,
} from '../../../../tests/support/demo-data.mjs';
import type { CoreDb } from '../../../nanocore/dist/storage/db.js';
import type { AdmittedNanoHostTransportStorage } from '../../../nanocore/dist/storage/nanohost-transport-owner.js';
import { seedSimulatorInferenceConfig } from './simulator-inference.js';

/**
 * Writes the explicit Demo Workspace fixture used by local-mode Web e2e tests.
 *
 * @param dataRoot NanoCore data root to seed.
 * @param providerBaseUrl Optional loopback Assistant provider for a configured-chat test.
 * @returns Resolves after the fixture records and storage owners are ready for boot.
 * @throws When fixture files or authority persistence fails.
 */
export async function seedDemoWorkspaceDataRoot(
  dataRoot: string,
  providerBaseUrl?: string
): Promise<void> {
  await seedSharedDemoWorkspaceDataRoot(dataRoot);
  await seedCommunicationOwner(dataRoot);
  await seedSimulatorInferenceConfig(dataRoot, providerBaseUrl);
  await seedDemoWorkspaceAuthority(dataRoot);
  await seedSimulatorAgent(dataRoot);
}

/**
 * Uses the fixture owner's normal proposal and confirmation to admit Assistant context Policy.
 *
 * Call while NanoCore is stopped so the fixture can release the native writer before boot.
 *
 * @param dataRoot Disposable local data root with canonical owner authority.
 */
export async function confirmFixtureAssistantContext(dataRoot: string): Promise<void> {
  const [
    { openCoreDb },
    { FsStore },
    { createRuntimeConfigManager },
    { confirmContextDefaults },
    { shutdownControlStoreWorkerClient },
  ] = await Promise.all([
    import('../../../nanocore/dist/storage/db.js'),
    import('../../../nanocore/dist/lib/store.js'),
    import('../../../nanocore/dist/config/runtime-config.js'),
    import('../../../nanocore/dist/test-support/confirm-context-defaults.js'),
    import('../../../nanocore/dist/storage/control-store-worker-client.js'),
  ]);
  const coreDb = openCoreDb(dataRoot);
  try {
    await confirmContextDefaults(
      coreDb,
      new FsStore({ dataRoot }),
      createRuntimeConfigManager({ dataRoot })
    );
  } finally {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
  }
}

/** Provisions Communication because the seeded Core is already an existing root at boot. */
async function seedCommunicationOwner(dataRoot: string): Promise<void> {
  const [
    { communicationOwner },
    { getControlStoreWorkerClient, shutdownControlStoreWorkerClient },
  ] = await Promise.all([
    import('../../../nanocore/dist/storage/communication-owner.js'),
    import('../../../nanocore/dist/storage/control-store-worker-client.js'),
  ]);
  try {
    const status = await getControlStoreWorkerClient().provisionServerOwner(
      dataRoot,
      communicationOwner
    );
    if (status.state !== 'ready')
      throw new Error(`Web e2e Communication storage is unavailable: ${status.reason}.`);
  } finally {
    await shutdownControlStoreWorkerClient();
  }
}

/** Releases the fixture process's database handles before boot, restart or cleanup. */
async function withFixtureCore<Value>(
  dataRoot: string,
  use: (coreDb: CoreDb) => Value | Promise<Value>
): Promise<Value> {
  const [{ openCoreDb }, { shutdownControlStoreWorkerClient }] = await Promise.all([
    import('../../../nanocore/dist/storage/db.js'),
    import('../../../nanocore/dist/storage/control-store-worker-client.js'),
  ]);
  const coreDb = openCoreDb(dataRoot);
  try {
    return await use(coreDb);
  } finally {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
  }
}

/** Reads the existing NanoHost owner and releases its opening before returning. */
export async function readFixtureNanoHost<Value>(
  dataRoot: string,
  use: (read: AdmittedNanoHostTransportStorage['owner']['read']) => Value
): Promise<Value> {
  const { reopenAdmittedTestNanoHost } = await import(
    '../../../nanocore/dist/test-support/admitted-nanohost.js'
  );
  return withFixtureCore(dataRoot, async (coreDb) => {
    const { value } = await reopenAdmittedTestNanoHost(coreDb);
    return use(value.owner.read);
  });
}

/**
 * Installs the synthetic self-check scheduler RuntimeTarget on the admitted fixture owner.
 * Call after Core startup, which invalidates the previous physical generation.
 */
export async function seedSyntheticLocalSchedulerTarget(dataRoot: string): Promise<void> {
  const [
    { readDataRootLayoutMarker },
    { transitionAdmittedNanoHostRuntimeTarget },
    { openAdmittedTestNanoHost },
  ] = await Promise.all([
    import('../../../nanocore/dist/storage/fs-layout.js'),
    import('../../../nanocore/dist/storage/nanohost-transport-owner.js'),
    import('../../../nanocore/dist/test-support/admitted-nanohost.js'),
  ]);
  await withFixtureCore(dataRoot, async (coreDb) => {
    const { value: storage } = await openAdmittedTestNanoHost(coreDb);
    const observedAt = new Date().toISOString();
    const allocated = await transitionAdmittedNanoHostRuntimeTarget(storage, {
      kind: 'allocate',
      deploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
      identityId: 'identity_local',
      observedAt,
      targetId: 'target_local',
    });
    if (allocated.state !== 'ready')
      throw new Error(`Web e2e RuntimeTarget allocation: ${allocated.owner} ${allocated.reason}.`);
    if (!allocated.value) throw new Error('Web e2e RuntimeTarget allocation returned no target.');
    const { connectionGeneration, deploymentId, identityId, targetId } = allocated.value;
    const ready = await transitionAdmittedNanoHostRuntimeTarget(storage, {
      kind: 'ready',
      connectionGeneration,
      deploymentId,
      identityId,
      targetId,
      freshEmpty: true,
      observedAt,
      // A restarted simulator represents a new empty process after the old Epoch is fenced.
      physicalEpoch:
        connectionGeneration === 1
          ? 'a'.repeat(64)
          : connectionGeneration.toString(16).padStart(64, '0'),
      predecessorFenced: true,
      ready: true,
    });
    if (ready.state !== 'ready')
      throw new Error(`Web e2e RuntimeTarget readiness: ${ready.owner} ${ready.reason}.`);
    if (!ready.value) throw new Error('Web e2e RuntimeTarget readiness returned no target.');
  });
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
  const manifest = {
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
  };
  await writeFile(join(agentsRoot, 'codex.agent.jsonc'), `${JSON.stringify(manifest, null, 2)}\n`);
  const [{ AuthoredAgentConfigSchema }, { admitTestNativeEnvironmentForRoot }] = await Promise.all([
    import('../../../nanocore/dist/agents/manifest.js'),
    import('../../../nanocore/dist/test-support/native-environment.js'),
  ]);
  await withFixtureCore(dataRoot, (coreDb) =>
    admitTestNativeEnvironmentForRoot(coreDb, AuthoredAgentConfigSchema.parse(manifest))
  );
}
