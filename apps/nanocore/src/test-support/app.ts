import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { type CreateAppOptions, createApp as createNanoCoreApp } from '../app.js';
import { resolveSessionDeploymentAdminTokenId } from '../auth/access-token-store.js';
import type { Actor } from '../auth/identity.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { ProviderRegistry } from '../providers/registry.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { createTestAgentSetup, createTestGatewayConfig } from './agent-environment.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from './local-user.js';
import { admitTestNativeEnvironment } from './native-environment.js';

export type { CreateAppOptions } from '../app.js';

/** One real fixture owner follows the existing process-local native-client lifetime. */
let fixtureNativeOwner:
  | {
      client: ReturnType<typeof getControlStoreWorkerClient>;
      admission: WorkspaceMutationAdmission;
    }
  | undefined;

/** Supplies the explicit physical peer of a local in-process test transport without adding credentials. */
export function createLoopbackAppFetch(
  app: Pick<ReturnType<typeof createNanoCoreApp>, 'fetch'>
): typeof fetch {
  return async (input, init) =>
    app.fetch(new Request(input, init), {
      incoming: { socket: { remoteAddress: '127.0.0.1' } },
    });
}

/** Projects a fixture's newly authenticated session through the current Token owner without minting authority. */
export function createTestSessionActor(coreDb: CoreDb, userId: string): Actor {
  const adminTokenId = resolveSessionDeploymentAdminTokenId(coreDb, userId);
  return { kind: 'session', userId, ...(adminTokenId ? { adminTokenId } : {}) };
}

/** Supplies explicit fixture identity and the real owner shared by one durable fixture lifetime. */
export function createAppWithLocalIdentity(
  options: CreateAppOptions = {}
): ReturnType<typeof createNanoCoreApp> {
  let admission = options.workspaceMutationAdmission ?? options.automationStore?.mutationAdmission;
  const dataRoot = options.dataRoot ?? options.store?.getDataRoot() ?? options.coreDb?.dataRoot;
  if (dataRoot) {
    const client = getControlStoreWorkerClient();
    // Explicit shutdown inside a case creates a new client identity. A fresh Store
    // gets a fresh default gate; surviving Stores must name their existing owner.
    if (fixtureNativeOwner?.client !== client) {
      fixtureNativeOwner = { client, admission: admission ?? new WorkspaceMutationAdmission() };
    }
    // Preserve explicitly different owners so the real invariant still refuses
    // competing live Apps rather than having this fixture silently replace one.
    admission ??= fixtureNativeOwner.admission;
  }
  return createNanoCoreApp({
    ...(!options.coreDb && options.mode !== 'server' ? { localUserId: FIXTURE_LOCAL_USER_ID } : {}),
    ...options,
    ...(admission ? { workspaceMutationAdmission: admission } : {}),
  });
}

/**
 * Creates a NanoCore app with an explicit deterministic executor and shared file admission for unit tests.
 *
 * @param options Production app options, including an optional executor override.
 * @returns NanoCore app configured for deterministic unit tests.
 */
export function createApp(options: CreateAppOptions = {}): ReturnType<typeof createNanoCoreApp> {
  if (options.coreDb) {
    admitTestNativeEnvironment(options.coreDb, createTestAgentSetup().manifest);
    for (const manifest of options.agentManifests ??
      options.runtimeConfigManager?.current().agentManifests ??
      [])
      admitTestNativeEnvironment(options.coreDb, manifest);
  }
  const ownsRuntimeConfig = !options.runtimeConfigManager && !options.gatewayConfig;
  const defaultProviderRegistry = new ProviderRegistry([
    {
      defaultModel: 'openai/gpt-5.2',
      displayName: 'Test inference provider',
      id: 'agent-openrouter',
      kind: 'local',
      models: ['openai/gpt-5.2'],
    },
  ]);
  const providerSupportsDefaultGateway =
    !options.providerRegistry ||
    options.providerRegistry.get('agent-openrouter')?.models.includes('openai/gpt-5.2') === true;
  const fileAdmission =
    options.fileAdmission ??
    new FileStorageAdmission(
      options.dataRoot ?? options.store?.getDataRoot() ?? options.coreDb?.dataRoot ?? '.',
      () =>
        BigInt(
          options.runtimeConfigManager?.current().openKitConfig.server?.fileReserveBytes ??
            options.openKitConfig?.server?.fileReserveBytes ??
            1_000_000_000
        )
    );
  const turnExecutor =
    options.turnExecutor ?? new SimulatedTurnExecutor({ coreDb: options.coreDb, fileAdmission });
  return createAppWithLocalIdentity({
    ...(ownsRuntimeConfig && providerSupportsDefaultGateway
      ? { gatewayConfig: createTestGatewayConfig() }
      : {}),
    ...(ownsRuntimeConfig && !options.providerRegistry
      ? { providerRegistry: defaultProviderRegistry }
      : {}),
    ...options,
    fileAdmission,
    turnExecutor,
  });
}

/** Databases owned only by tests that exercise local HTTP through canonical Workspace authority. */
const workspaceAuthorityFixtures: Array<{
  coreDb: ReturnType<typeof openCoreDb>;
  dataRoot: string;
  ownsRoot: boolean;
}> = [];

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  fixtureNativeOwner = undefined;
  for (const fixture of workspaceAuthorityFixtures.splice(0)) {
    if (fixture.coreDb.sqlite.open) fixture.coreDb.sqlite.close();
    if (fixture.ownsRoot) rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

/** Supplies real local identity and membership records for formerly storage-only HTTP fixtures; explicit and server authority stays caller-owned. */
export function createAppWithWorkspaceAuthority(
  options: CreateAppOptions = {}
): ReturnType<typeof createNanoCoreApp> {
  if (options.coreDb || options.mode === 'server' || !options.store) return createApp(options);
  // A file-backed Store already owns its prepared Workspace scopes. Keep Core relationships
  // in that exact root; a second empty root cannot stand in for native Knowledge authority.
  const storeRoot = options.store.getDataRoot();
  const dataRoot = storeRoot ?? mkdtempSync(join(tmpdir(), 'openkit-test-workspace-authority-'));
  const coreDb = openCoreDb(dataRoot);
  workspaceAuthorityFixtures.push({ coreDb, dataRoot, ownsRoot: !storeRoot });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  for (const workspace of options.store.listWorkspaces()) {
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      workspaceId: workspace.id,
    });
  }
  return createApp({ ...options, coreDb });
}
